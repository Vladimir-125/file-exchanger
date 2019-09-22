	// p5.js star drawing
		var canvas;
		let speed;
		var stars = [];

		function windowResized(){
			resizeCanvas(windowWidth, windowHeight);
		}

		function setup(){
			canvas = createCanvas(windowWidth, windowHeight);
			canvas.position(0, 0);
			canvas.style('z-index', '-1');

			 for(let i =0; i<100; i++){
   				 stars[i]=new Star();
  			}
		}

		function draw(){

			speed = 3;//map(mouseX, 0, width, 0, 20);
  
		    background('#00265C');
		    translate(width/2,height/2);
		  
		    for(let i =0; i<stars.length; i++){
		    stars[i].move();
		    stars[i].display();
		    
		  	}		
		}

		function Star(){

		    this.x= random(-windowWidth, windowWidth);
		    this.y= random(-windowHeight,windowHeight);
		    this.s= random(windowWidth);
		    this.ps=this.s;
		    
		    this.move = function(){
			    this.s=this.s - speed;
			    
			    //create new star when the old one 
			    if (this.s < 1) {
			      this.s = windowWidth/2;
			      this.x = random(-windowWidth/2, windowWidth/2);
			      this.y = random(-windowHeight/2, windowHeight/2);
			      this.ps = this.s;
			    }
		    }
		    
		    this.display = function(){
		    
		    let cx=map(this.x/this.s, 0, 1, 0, windowWidth/2);
		    let cy=map(this.y/this.s, 0, 1, 0, windowHeight/2);
		  
		    //fill(map(mouseY, 0, windowHeight, 100, 255), 0, map(mouseX, 0, windowWidth, 100, 255));
		    fill('#fffff');
		    stroke('white')
		    let r = map(this.s, 0, windowWidth/2, 16, 0);
		    ellipse(cx, cy, r, r);

		    let px=map(this.x/this.ps, 0, 1, 0, windowWidth/2);
		    let py=map(this.y/this.ps, 0, 1, 0, windowHeight/2);  
		  
		    ps = this.s;
		  }
		}
